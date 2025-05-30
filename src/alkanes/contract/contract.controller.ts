import { Controller, Post, Body } from '@nestjs/common'; // Removed UsePipes, ValidationPipe as global pipe is used
import { ContractService } from './contract.service.js';
import { PreDeployDto, DeployDto, ExecuteDto } from './contract.types.js';

@Controller('alkanes')
export class ContractController {
  constructor(private readonly contractsService: ContractService) { }

  @Post('preDeploy')
  async preDeployContract(@Body() preDeployDto: PreDeployDto) {
    // Basic logging to see if DTO is received correctly
    console.log('Received preDeployDto in controller:', preDeployDto);
    return this.contractsService.preDeployContract(preDeployDto);
  }

  @Post('deploy')
  async deployContract(@Body() deployDto: DeployDto) {
    console.log('Received deployDto:', deployDto);
    return this.contractsService.deployContract(deployDto);
  }

  @Post('execute')
  async executeContractMethod(@Body() executeDto: ExecuteDto) {
    console.log('Received executeDto:', executeDto);
    return this.contractsService.executeContractMethod(executeDto);
  }
}
